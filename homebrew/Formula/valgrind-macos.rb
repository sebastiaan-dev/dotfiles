# Based on LouisBrunner/homebrew-valgrind, with SDK selection scoped to this build.
class ValgrindMacos < Formula
  desc "Dynamic analysis tools from the macOS-compatible Valgrind fork"
  homepage "https://github.com/LouisBrunner/valgrind-macos"
  license "GPL-2.0-only"
  depends_on :macos
  conflicts_with "valgrind", because: "both install the same executables"

  head do
    url "https://github.com/LouisBrunner/valgrind-macos.git", branch: "main"
    depends_on "autoconf" => :build
    depends_on "automake" => :build
    depends_on "libtool" => :build
  end

  # Preserve the fork's architecture flags and allow a build-local xcrun shim.
  env :std
  skip_clean "lib/valgrind"

  def install
    sdk = Pathname(MacOS.sdk_path)
    matching_sdks = sdk.parent.glob("MacOSX#{MacOS.version.major}*.sdk").map(&:realpath).uniq
    sdk = matching_sdks.max_by { |path| Version.new(path.basename.to_s[/\d+(?:\.\d+)*/]) } || sdk

    # Prefer the running OS's SDK over a newer beta SDK selected by the CLT.
    ENV.remove_macosxsdk
    ENV["SDKROOT"] = sdk.to_s
    ENV["CPATH"] = (HOMEBREW_PREFIX/"include").to_s
    ENV.append_to_cflags "-isysroot#{sdk}"
    ENV.append "CPPFLAGS", "-isysroot#{sdk}"
    ENV.append "LDFLAGS", "-isysroot#{sdk}"

    sdk_bin = buildpath/"sdk-bin"
    sdk_bin.mkpath
    (sdk_bin/"xcrun").write <<~SH
      #!/bin/bash
      set -euo pipefail
      if [[ $# -ge 2 && "$1" == "--sdk" && "$2" == "macosx" ]]; then
        shift 2
        exec /usr/bin/xcrun --sdk "$SDKROOT" "$@"
      fi
      exec /usr/bin/xcrun "$@"
    SH
    (sdk_bin/"xcrun").chmod 0755
    ENV.prepend_path "PATH", sdk_bin

    # Linker fix from upstream PR #204 (cf288f6e), pending its merge into main.
    # Recent CLT linkers otherwise place data segments below Valgrind's text.
    linker = buildpath/"coregrind/link_tool_exe_darwin.in"
    unless linker.read.include?("-segaddr __DATA_CONST")
      inreplace linker do |s|
        s.gsub! '    $cmd = "$cmd -segaddr __TEXT $ala";', <<~'PERL'.chomp
              $cmd = "$cmd -segaddr __TEXT $ala";
              if (@DARWIN_VERS@ >= 260000) {
                  my $data_const_ala = (Math::BigInt->new($ala) + Math::BigInt->new("0x10000000"))->as_hex();
                  my $data_ala = (Math::BigInt->new($ala) + Math::BigInt->new("0x20000000"))->as_hex();
                  $cmd = "$cmd -segaddr __DATA_CONST $data_const_ala";
                  $cmd = "$cmd -segaddr __DATA $data_ala";
              }
        PERL
        s.gsub! "if (@DARWIN_VERS@ >= 140000) {",
                "if (@DARWIN_VERS@ >= 140000 && @DARWIN_VERS@ < 260000) {"
      end
    end

    system "./autogen.sh"
    system "./configure", "--disable-dependency-tracking", "--prefix=#{prefix}"
    system "make"
    system "make", "install"
  end

  def post_install
    return unless Hardware::CPU.arm?

    {
      "libmydyld.so" => "/usr/lib/system/libdyld.dylib",
      "libmySystem.so" => "/usr/lib/libSystem.B.dylib",
    }.each do |library, install_name|
      path = libexec/"valgrind"/library
      system "install_name_tool", "-id", install_name, path
      system "codesign", "--force", "--sign", "-", path
    end
  end

  test do
    (testpath/"smoke.c").write <<~C
      #include <stdlib.h>
      int main(void) {
        volatile char *p = malloc(16);
        if (p == NULL) return 1;
        p[0] = 42;
        free((void *)p);
        return 0;
      }
    C
    system ENV.cc, "-g", "smoke.c", "-o", "smoke"
    system bin/"valgrind", "--error-exitcode=1", "--leak-check=full", "./smoke"
  end
end
